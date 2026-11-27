package id.legend.edcbridge.data

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction

/** Sale dedupe records. Not touched by `ack`. */
@Entity(tableName = "sale_records")
data class SaleRecordEntity(
    @PrimaryKey val key: String,
    @ColumnInfo(name = "command_id") val commandId: String,
    @ColumnInfo(name = "terminal_id") val terminalId: String,
    val trace: String,
    @ColumnInfo(name = "frame_sha256") val frameSha256: String,
    /** `in_flight` | `done`. */
    val state: String,
    /** Answer JSON, null while in flight. */
    @ColumnInfo(name = "answer_json") val answerJson: String?,
    @ColumnInfo(name = "stored_at_wall_ms") val storedAtWallMs: Long,
    @ColumnInfo(name = "stored_at_mono_ms", index = true) val storedAtMonoMs: Long,
    val released: Boolean,
)

/** Results waiting for the cloud's `ack`, oldest first. */
@Entity(tableName = "unacked_results", indices = [Index(value = ["command_id"], unique = true)])
data class UnackedResultEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    @ColumnInfo(name = "command_id") val commandId: String,
    @ColumnInfo(name = "result_json") val resultJson: String,
)

@Dao
interface JournalDao {
    @Query("SELECT * FROM sale_records WHERE `key` = :key")
    fun saleRecord(key: String): SaleRecordEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertSaleRecord(record: SaleRecordEntity)

    @Query("UPDATE sale_records SET state = 'done', answer_json = :answerJson WHERE `key` = :key")
    fun markSaleDone(key: String, answerJson: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertUnacked(result: UnackedResultEntity)

    @Transaction
    fun finishSale(key: String, answerJson: String, result: UnackedResultEntity) {
        markSaleDone(key, answerJson)
        insertUnacked(result)
    }

    @Query("SELECT * FROM unacked_results ORDER BY seq")
    fun unacked(): List<UnackedResultEntity>

    @Query("SELECT COUNT(*) FROM unacked_results")
    fun unackedCount(): Int

    @Query("DELETE FROM unacked_results WHERE command_id = :commandId")
    fun deleteUnacked(commandId: String)

    @Query("UPDATE sale_records SET released = 1 WHERE `key` IN (:keys)")
    fun release(keys: List<String>)

    @Query("SELECT * FROM sale_records WHERE state = 'in_flight'")
    fun inFlight(): List<SaleRecordEntity>

    @Query("SELECT * FROM sale_records WHERE stored_at_mono_ms <= :monoCutoffMs")
    fun storedBefore(monoCutoffMs: Long): List<SaleRecordEntity>

    @Query("DELETE FROM sale_records WHERE `key` IN (:keys)")
    fun delete(keys: List<String>)
}

@Database(entities = [SaleRecordEntity::class, UnackedResultEntity::class], version = 1, exportSchema = true)
abstract class JournalDatabase : RoomDatabase() {
    abstract fun journal(): JournalDao

    companion object {
        fun open(context: Context): JournalDatabase =
            Room.databaseBuilder(context, JournalDatabase::class.java, "edc-bridge-journal.db").build()
    }
}
